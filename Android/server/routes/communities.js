import { Router } from 'express';
import multer from 'multer';
import CommunityRepo from '../models/CommunityRepository.js';
import PetRepo from '../models/PetRepository.js';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { uploadWithQuota } from '../services/mediaService.js';
import config from '../config.js';
import db from '../db/connection.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { canCreateCommunity, canJoinCommunity } from '../services/premiumGate.js';
import { sendServerError } from '../utils/errors.js';
import { requirePet } from '../middleware/requirePet.js';
import { isCommunityFrozen, communityReadOnlyBody, COMMUNITY_UNAVAILABLE_BODY } from '../utils/sniffedOut.js';
import { circleMediaType, isOwnUploadUrl, INVALID_MEDIA_BODY } from '../utils/circleMedia.js';
import { leaveCircle } from '../services/frozenCircles.js';
import {
  requestToJoin, cancelJoinRequest, listJoinRequests, acceptJoinRequest, declineJoinRequest,
  cancelPendingRequestsForCircles,
} from '../services/circleJoinRequests.js';
import {
  getTransferFor, startTransfer, cancelTransfer, acceptTransfer, declineTransfer, notifyCancelledTransfers,
} from '../services/circleOwnershipTransfers.js';

const router = Router();
router.use(authenticateAccess);
// Every other route file (auth.js, calls.js, notifications.js, spotlight.js)
// applies a blanket default so nothing is reachable without SOME limit --
// this file instead relied on an ad-hoc rateLimiter(...) added to each POST
// individually, which is how POST / (create community) ended up with none
// at all. The per-route POST limiters below are still stricter and still
// apply on top of this (the key includes req.method, so this and a route's
// own limiter track separate buckets; the stricter one is what actually
// binds), this is just the floor every GET and any POST route here should
// have had regardless.
router.use(rateLimiter(config.RATE_LIMIT.GET));

// Every route below that declares :id (community detail, messages, photos,
// members, ownership-transfer, ...) accepts either the numeric id or the
// readable slug (see db/sql/2026-10-13_community_slug.sql) -- resolved once,
// here, rather than in each of the ~30 handlers that use :id. A slug that
// doesn't match anything is rewritten to an id no community can ever have,
// so the handler's own normal numeric lookup just finds nothing and 404s
// the usual way, instead of Postgres throwing a type-mismatch error trying
// to compare an integer column against non-numeric text.
router.param('id', async (req, res, next, value) => {
  if (/^\d+$/.test(value)) return next();
  try {
    const match = await CommunityRepo.findBySlug(value);
    req.params.id = match ? String(match.id) : '-1';
    next();
  } catch (err) {
    next(err);
  }
});

const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO = ['video/mp4', 'video/quicktime', 'video/webm'];
const ALL_ALLOWED = [...ALLOWED_IMAGE, ...ALLOWED_VIDEO];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALL_ALLOWED.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPG, PNG, WEBP, MP4, MOV, WEBM.`));
    }
    cb(null, true);
  }
});

async function requireRole(communityId, userId, allowedRoles) {
  const member = await db.get(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?',
    [communityId, userId]
  );
  if (!member) return { ok: false, status: 403, error: 'NOT_A_MEMBER', message: 'You must be a member of this PawCircle to do this.' };
  if (!allowedRoles.includes(member.role)) {
    return { ok: false, status: 403, error: 'FORBIDDEN', message: 'Only the Owner or an Admin can do this.' };
  }
  return { ok: true, role: member.role };
}

const MEMBER_ROLES = ['Owner', 'Admin', 'Moderator', 'Member'];

// requireRole as middleware, so the check runs before any upload or write.
// 403 NOT_A_MEMBER for outsiders, 403 FORBIDDEN for a role that isn't allowed.
const requireMember = (allowedRoles = MEMBER_ROLES) => async (req, res, next) => {
  try {
    const check = await requireRole(parseInt(req.params.id, 10), req.user.id, allowedRoles);
    if (!check.ok) return res.status(check.status).json({ error: check.error, message: check.message });
    req.communityRole = check.role;
    next();
  } catch (err) {
    sendServerError(res, err);
  }
};

// A frozen circle (owner SniffedOut) is read-only: every write is refused
// here, before premium checks, uploads or any row is touched. Reading and
// leaving stay allowed.
// A disabled circle (archived by its Owner) is read-only the same way for its
// members, and simply unavailable to everyone else.
async function rejectIfFrozen(req, res, next) {
  try {
    const readOnly = await communityReadOnlyBody(req.params.id);
    if (readOnly) {
      if (readOnly.reason === 'disabled' && !(await CommunityRepo.isMember(req.params.id, req.user.id))) {
        return res.status(404).json(COMMUNITY_UNAVAILABLE_BODY);
      }
      return res.status(403).json(readOnly);
    }
    next();
  } catch (err) {
    sendServerError(res, err);
  }
}

// Someone who just left stops getting the circle's live events right away.
function dropFromCircleRoom(req, communityId) {
  req.app.get('io')?.in(`user_${req.user.id}`).socketsLeave(`pawcircle_${communityId}`);
}

router.get('/validate', async (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) return res.json({ available: false });
    const existing = await db.get('SELECT id FROM communities WHERE LOWER(name) = LOWER(?)', [name]);
    res.json({ available: !existing });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', available: false });
  }
});

router.get('/', async (req, res) => {
  try {
    const { q, category, breed, pet_type, city, tags, recommended } = req.query;
    const userId = req.user.id;

    if (recommended === 'true') {
      const pet = await PetRepo.findByUserId(userId);
      const recs = await CommunityRepo.getRecommendedForPet(pet, userId);
      const withStatus = await Promise.all(recs.map(c => CommunityRepo.getDetailsWithStatus(c.id, userId)));
      return res.json({ communities: withStatus });
    }

    const results = await CommunityRepo.search({ q, category, breed, pet_type, city, tags, userId });
    const withStatus = await Promise.all(results.map(c => CommunityRepo.getDetailsWithStatus(c.id, userId)));
    res.json({ communities: withStatus });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/', requirePet, rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const io = req.app.get('io');
    const premiumCheck = await canCreateCommunity(req.user.id, io);
    if (!premiumCheck.allowed) {
      return res.status(403).json({
        error: premiumCheck.reason,
        message: `Free accounts can create up to ${premiumCheck.limit} PawCircles. Upgrade to Premium to create unlimited PawCircles.`,
        plan: premiumCheck.plan,
        limit: premiumCheck.limit,
      });
    }

    const {
      name, description, category, breed, pet_type, city,
      cover_image = '/communities/general.jpg',
      icon_image = 'groups',
      is_private = 0,
      rules = '1. Be kind and respectful to all pet parents.\n2. Keep vaccinations up to date.\n3. No spam.',
      tags
    } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ error: 'MISSING_NAME', message: 'Community name is required' });
    const trimmedName = name.trim();
    const existing = await db.get('SELECT id FROM communities WHERE LOWER(name) = LOWER(?)', [trimmedName]);
    if (existing) {
      return res.status(400).json({ error: 'DUPLICATE_NAME', message: 'This community name is already taken.' });
    }

    const invite_code = `PAW-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${new Date().getFullYear()}`;
    const slug = await CommunityRepo.generateUniqueSlug(trimmedName);
    let community;
    try {
      community = await CommunityRepo.create({
        name: trimmedName,
        slug,
        description: description || '',
        category: category || 'General',
        breed: breed || '',
        pet_type: pet_type || 'All',
        city: city || 'India',
        cover_image,
        icon_image,
        is_private: is_private ? 1 : 0,
        rules,
        created_by: req.user.id,
        member_count: 1,
        invite_code,
        tags: tags || ''
      });
    } catch (err) {
      // 23505 = unique_violation -- the SELECT check above can't fully close
      // the race between two near-simultaneous creates of the same name (a
      // double-tap on "Create", a retried request after a slow response
      // that actually went through); idx_communities_name_unique
      // (db/sql/2026-10-13_community_name_unique.sql) is the real backstop.
      if (err.code === '23505') {
        return res.status(400).json({ error: 'DUPLICATE_NAME', message: 'This community name is already taken.' });
      }
      throw err;
    }

    await CommunityRepo.join(community.id, req.user.id, 'Owner');

    const details = await CommunityRepo.getDetailsWithStatus(community.id, req.user.id);
    res.status(201).json({ community: details });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const community = await CommunityRepo.getDetailsWithStatus(req.params.id, req.user.id);
    if (!community) return res.status(404).json({ error: 'NOT_FOUND', message: 'PawCircle community not found' });
    // Frozen and disabled circles are invisible to non-members (search,
    // invite links...). A private circle shows non-members only its public
    // info (see CommunityRepository.getDetailsWithStatus).
    if ((community.frozen || community.disabled) && !community.userRole) return res.status(404).json(COMMUNITY_UNAVAILABLE_BODY);
    res.json({ community });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/delete-group', requireMember(), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const userId = req.user.id;
    // On a frozen circle "delete from my list" means leaving it for good:
    // nothing new will ever arrive to bring it back.
    if (await isCommunityFrozen(communityId)) {
      const result = await leaveCircle(communityId, userId);
      dropFromCircleRoom(req, communityId);
      await notifyCancelledTransfers(req.app.get('io'), result.cancelledTransfers, userId, 'left');
      return res.json({ success: true, left: true, deleted: result.deleted, message: 'You left this PawCircle.' });
    }
    await CommunityRepo.deleteGroupForUser(communityId, userId);
    res.json({ success: true, message: 'PawCircle group deleted locally.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/report', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { reason, details } = req.body;
    await db.run(
      `INSERT INTO post_reports (user_id, reason, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [req.user.id, `Community #${req.params.id}: ${reason}${details ? ` - ${details}` : ''}`]
    );
    res.json({ success: true, message: 'Report submitted successfully.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/disable', rejectIfFrozen, requireMember(), async (req, res) => {
  try {
    const communityId = req.params.id;
    const community = await CommunityRepo.findById(communityId);
    if (!community) return res.status(404).json({ error: 'NOT_FOUND' });

    // Checks the live 'Owner' role in community_members, not the static
    // communities.created_by column (an accepted ownership transfer updates
    // both, see services/circleOwnershipTransfers.js).
    const member = await db.get('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, req.user.id]);
    if (!member || member.role !== 'Owner') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only the Owner can disable this PawCircle.' });
    }

    // Disabling archives the circle (communities.disabled_at): read-only for
    // every member like a frozen one (rejectIfFrozen + the socket handlers),
    // hidden from search and recommendations, no new members. Pending join
    // requests and a pending ownership transfer are cancelled. The Owner can
    // re-enable it (POST /:id/enable).
    const id = parseInt(communityId, 10);
    await db.run('UPDATE communities SET disabled_at = COALESCE(disabled_at, NOW()) WHERE id = ?', [id]);
    await cancelPendingRequestsForCircles([id]);
    const cancelledTransfers = await db.all(
      `UPDATE community_ownership_transfers SET status = 'cancelled', responded_at = NOW()
       WHERE community_id = ? AND status = 'pending' RETURNING id, community_id, from_user_id, to_user_id`, [id]);
    const io = req.app.get('io');
    await notifyCancelledTransfers(io, cancelledTransfers, req.user.id, 'disabled');
    io?.to(`pawcircle_${id}`).emit('community_disabled', { communityId: id });
    res.json({ success: true, message: 'PawCircle disabled successfully.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/communities/:id/enable -- the Owner re-enables a disabled circle:
// back to normal (join requests cancelled at disable stay cancelled).
router.post('/:id/enable', requireMember(['Owner']), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await db.get(
      'UPDATE communities SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL RETURNING id', [id]);
    if (!row) return res.status(409).json({ error: 'NOT_DISABLED', message: 'This PawCircle is not disabled.' });
    req.app.get('io')?.to(`pawcircle_${id}`).emit('community_enabled', { communityId: id });
    res.json({ success: true, community: await CommunityRepo.getDetailsWithStatus(id, req.user.id) });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── POST /api/communities/:id/join ──────────────────────────────
// Now sends a REAL notification to the community's Owner and Admins
// (not just a chat system message, as before). Reuses the same
// sendRealtimeNotification infrastructure and category: 'pawcircle',
// which the frontend NotificationsPanel already knows how to route
// (navigates to /community/:id) -- no frontend changes were needed.
router.post('/:id/join', requirePet, rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, async (req, res) => {
  try {
    const io = req.app.get('io');
    const target = await db.get('SELECT is_private, disabled_at FROM communities WHERE id = ?', [parseInt(req.params.id, 10) || 0]);
    if (!target) return res.status(404).json({ error: 'NOT_FOUND', message: 'PawCircle community not found' });
    if (target.disabled_at) return res.status(404).json(COMMUNITY_UNAVAILABLE_BODY);
    if (await CommunityRepo.isMember(req.params.id, req.user.id)) {
      return res.json({ community: await CommunityRepo.getDetailsWithStatus(req.params.id, req.user.id) });
    }
    // Private circles: joining always goes through a request the Owner or an
    // Admin accepts -- invite links included (they only open the page).
    if (target.is_private) {
      return res.status(403).json({ error: 'APPROVAL_REQUIRED', message: 'This PawCircle is private. Send a request to join.' });
    }
    const premiumCheck = await canJoinCommunity(req.user.id, io);
    if (!premiumCheck.allowed) {
      return res.status(403).json({
        error: premiumCheck.reason,
        message: `Free accounts can join up to ${premiumCheck.limit} PawCircles. Upgrade to Premium to join unlimited PawCircles.`,
        plan: premiumCheck.plan,
        limit: premiumCheck.limit,
      });
    }

    const communityId = parseInt(req.params.id, 10);
    const updated = await CommunityRepo.join(communityId, req.user.id, 'Member');

    const pet = await PetRepo.findByUserId(req.user.id);
    const petName = pet ? pet.name : 'A new playmate';

    const welcomeMsg = await CommunityRepo.addMessage({
      community_id: communityId,
      sender_id: req.user.id,
      content: `🐾 ${petName} joined the pack!`,
      message_type: 'system'
    });

    if (io) {
      io.to(`pawcircle_${communityId}`).emit('community_message_received', welcomeMsg);

      // Notify Owner + Admins (never the joiner themselves)
      const community = await CommunityRepo.findById(communityId);
      const leadership = await db.all(
        "SELECT user_id FROM community_members WHERE community_id = ? AND role IN ('Owner', 'Admin')",
        [communityId]
      );
      for (const leader of leadership) {
        if (leader.user_id === req.user.id) continue;
        await sendRealtimeNotification(io, leader.user_id, {
          category: 'pawcircle',
          type: 'community_join',
          title: `${petName} joined ${community?.name || 'your PawCircle'}! 🐾`,
          description: `${petName} just joined your PawCircle.`,
          avatarUrl: pet?.avatar_url || null,
          targetId: String(communityId),
          senderPetId: pet?.id || null,
          metadata: { community_id: communityId },
        });
      }
    }

    res.json({ community: updated });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Join requests (private circles) ────────────────────────────────
// See services/circleJoinRequests.js. Requests are managed by the circle's
// Owner and Admins (the roles that already manage members).
const sendResult = (res, { status, body }) => res.status(status).json(body);

// POST /api/communities/:id/join-request -- ask to join a private circle.
router.post('/:id/join-request', requirePet, rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, async (req, res) => {
  try {
    sendResult(res, await requestToJoin(req.params.id, req.user.id, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

// DELETE /api/communities/:id/join-request -- withdraw your pending request.
router.delete('/:id/join-request', async (req, res) => {
  try {
    sendResult(res, await cancelJoinRequest(req.params.id, req.user.id, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/communities/:id/join-requests -- Owner/Admin: pending requests.
router.get('/:id/join-requests', requireMember(['Owner', 'Admin']), async (req, res) => {
  try {
    sendResult(res, await listJoinRequests(req.params.id));
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/join-requests/:requestId/accept', rejectIfFrozen, requireMember(['Owner', 'Admin']), async (req, res) => {
  try {
    sendResult(res, await acceptJoinRequest(req.params.id, req.params.requestId, req.user.id, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/join-requests/:requestId/decline', rejectIfFrozen, requireMember(['Owner', 'Admin']), async (req, res) => {
  try {
    sendResult(res, await declineJoinRequest(req.params.id, req.params.requestId, req.user.id, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Ownership transfer ─────────────────────────────────────────────
// See services/circleOwnershipTransfers.js. Only the Owner starts/cancels
// (and never on a frozen circle); only the recipient accepts/declines --
// also on a frozen circle, where accepting reactivates it.

// GET -- the pending transfer, for its two sides only (null otherwise).
router.get('/:id/ownership-transfer', requireMember(), async (req, res) => {
  try {
    sendResult(res, await getTransferFor(req.params.id, req.user.id));
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST { toUserId } -- offer the circle to a live member (replaces any pending one).
router.post('/:id/ownership-transfer', rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, requireMember(['Owner']), async (req, res) => {
  try {
    sendResult(res, await startTransfer(req.params.id, req.user.id, req.body?.toUserId, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/:id/ownership-transfer', requireMember(['Owner']), async (req, res) => {
  try {
    sendResult(res, await cancelTransfer(req.params.id, req.user.id, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/ownership-transfer/:transferId/accept', async (req, res) => {
  try {
    sendResult(res, await acceptTransfer(req.params.id, req.params.transferId, req.user.id, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/ownership-transfer/:transferId/decline', async (req, res) => {
  try {
    sendResult(res, await declineTransfer(req.params.id, req.params.transferId, req.user.id, req.app.get('io')));
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/members/:userId/role', rejectIfFrozen, requireMember(), async (req, res) => {
  try {
    const { role } = req.body;
    const communityId = req.params.id;
    const targetUserId = parseInt(req.params.userId);
    const requesterMember = { role: req.communityRole }; // set by requireMember()

    const allowedRoles = ['Admin', 'Moderator', 'Member'];
    // Ownership only moves through a transfer the new owner accepts
    // (POST /:id/ownership-transfer) -- never by a role change, which would
    // leave two Owners or none.
    if (role === 'Owner') {
      return res.status(400).json({ error: 'USE_OWNERSHIP_TRANSFER', message: 'Use Transfer Ownership to hand this PawCircle over.' });
    }
    if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'INVALID_ROLE' });

    const targetMember = await db.get('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, targetUserId]);
    if (!targetMember) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });
    if (targetMember.role === 'Owner') {
      return res.status(403).json({ error: 'FORBIDDEN', message: "The Owner's role can only change through an ownership transfer." });
    }

    if (requesterMember.role === 'Owner') {
      // Owner has full control
    } else if (requesterMember.role === 'Admin') {
      if (targetMember.role === 'Owner' || targetMember.role === 'Admin') {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
      if (role === 'Owner' || role === 'Admin') {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
    } else {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    await db.run('UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?', [role, communityId, targetUserId]);
    res.json({ success: true, role });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/leave', requireMember(), async (req, res) => {
  try {
    const result = await leaveCircle(req.params.id, req.user.id);
    // H9: the owner of a circle that still has other live members cannot
    // leave until they transfer ownership (POST /:id/ownership-transfer) --
    // nothing was mutated, so there's nothing to notify/clean up.
    if (result.blocked) {
      return res.status(409).json({
        error: result.reason,
        message: 'Transfer ownership to another member before leaving this PawCircle.',
      });
    }
    dropFromCircleRoom(req, parseInt(req.params.id, 10));
    await notifyCancelledTransfers(req.app.get('io'), result.cancelledTransfers, req.user.id, 'left');
    res.json({ success: true, deleted: result.deleted });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/members', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await CommunityRepo.getMembersPaginated(communityId, page, limit);
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/announcements', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const announcements = await CommunityRepo.getAnnouncements(communityId, req.query.highlightId);
    res.json({ announcements });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/announcements', rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, requireMember(['Owner', 'Admin']), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);

    const { title, content, latitude, longitude, is_event, location_name } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Title and content are required' });

    const isEvent = (is_event === true || is_event === 1 || is_event === '1') && latitude != null && longitude != null;
    const lat = isEvent ? parseFloat(latitude) : null;
    const lng = isEvent ? parseFloat(longitude) : null;
    const locationName = isEvent && typeof location_name === 'string' && location_name.trim()
      ? location_name.trim().slice(0, 300)
      : null;

    const announcement = await CommunityRepo.addAnnouncement({
      community_id: communityId,
      sender_id: req.user.id,
      title,
      content,
      latitude: lat,
      longitude: lng,
      is_event: isEvent ? 1 : 0,
      location_name: locationName,
    });

    const io = req.app.get('io');
    if (io) {
      const community = await CommunityRepo.findById(communityId);
      const preview = content.length > 100 ? `${content.slice(0, 100)}...` : content;

      const members = await CommunityRepo.getMembers(communityId);
      await Promise.all(members
        .filter(member => member.user_id !== req.user.id)
        .map(member => sendRealtimeNotification(io, member.user_id, {
          category: 'pawcircle',
          type: 'community_announcement',
          title: `${community?.name || 'PawCircle'} Announcement 📢`,
          description: `${title}: ${preview}`,
          avatarUrl: community?.icon_image || null,
          targetId: String(communityId),
          senderPetId: null,
          metadata: { community_id: communityId },
        })));

      // A private circle's announcements are for members only -- no nearby
      // notifications to non-members carrying the title and text.
      if (isEvent && !community?.is_private) {
        const nearbyNonMembers = await CommunityRepo.getNearbyNonMembers(communityId, lat, lng, 20);
        await Promise.all(nearbyNonMembers
          .filter(target => target.user_id !== req.user.id)
          .map(target => sendRealtimeNotification(io, target.user_id, {
            category: 'nearby',
            type: 'nearby_event',
            title: 'Nearby Event 📍',
            description: `${title} — happening near you! Hosted by ${community?.name || 'a PawCircle'}.`,
            avatarUrl: community?.icon_image || null,
            targetId: String(communityId),
            senderPetId: null,
            metadata: { community_id: communityId, is_event: true },
          })));
      }
    }

    res.status(201).json({ announcement });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/messages', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const messages = await CommunityRepo.getMessages(communityId, req.user.id);
    res.json({ messages });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/messages', rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, requireMember(), upload.single('media'), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);

    const { content, reply_to_id } = req.body;
    if (reply_to_id && !(await CommunityRepo.isMessageInCommunity(reply_to_id, communityId))) {
      return res.status(400).json({ error: 'INVALID_REPLY', message: 'You can only reply to a message in this PawCircle.' });
    }
    let media_url = req.body.media_url || null;
    // Without a file, a media URL must be one of our own uploads (re-sharing a
    // photo already on Sniffr), never an arbitrary outside link.
    if (media_url && !req.file && !(await isOwnUploadUrl(media_url))) {
      return res.status(400).json(INVALID_MEDIA_BODY);
    }

    if (req.file) {
      const isImage = req.file.mimetype.startsWith('image/');
      if (isImage && req.file.size > MAX_IMAGE_SIZE) {
        return res.status(400).json({ error: 'FILE_TOO_LARGE', message: 'Image must be under 10MB.' });
      }
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'community_media');
      media_url = uploaded.url;
    }

    if (!content && !media_url) return res.status(400).json({ error: 'MISSING_CONTENT' });

    // A photo or video is saved as a media message (its type from the upload
    // or the URL) -- never as a text message. Older app versions send the
    // file's name as the text: that's not a caption, so it's dropped.
    const caption = req.file && content === req.file.originalname ? '' : (content || '');
    const message = await CommunityRepo.addMessage({
      community_id: communityId,
      sender_id: req.user.id,
      content: caption,
      media_url: media_url || null,
      message_type: media_url ? circleMediaType({ mimetype: req.file?.mimetype, url: media_url }) : 'text',
      reply_to_id: reply_to_id || null
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`pawcircle_${communityId}`).emit('community_message_received', message);
    }

    res.status(201).json({ message });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/photos', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const photos = await CommunityRepo.getPhotos(communityId);
    res.json({ photos });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/photos', rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, requireMember(), upload.single('media'), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);

    if (!req.file) return res.status(400).json({ error: 'MISSING_FILE', message: 'A photo or video is required.' });

    const isImage = req.file.mimetype.startsWith('image/');
    if (isImage && req.file.size > MAX_IMAGE_SIZE) {
      return res.status(400).json({ error: 'FILE_TOO_LARGE', message: 'Image must be under 10MB.' });
    }

    const uploaded = await uploadWithQuota(req.user.id, req.file, 'community_photos');
    const media_url = uploaded.url;

    const photo = await CommunityRepo.addPhoto({
      community_id: communityId,
      user_id: req.user.id,
      media_url,
      caption: req.body.caption || ''
    });
    res.status(201).json({ photo });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/events', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const events = await CommunityRepo.getEvents(communityId);
    res.json({ events });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/polls', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const polls = await CommunityRepo.getPolls(communityId);
    res.json({ polls });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/communities/:id/polls { question, options } -- any member of an
// active circle (not frozen or disabled). 2-10 distinct options. Posts a
// "New Pack Poll" line in the chat and tells open pages.
const POLL_QUESTION_MAX = 200;
const POLL_OPTION_MAX = 100;
const POLL_OPTIONS_MIN = 2;
const POLL_OPTIONS_MAX = 10;
router.post('/:id/polls', rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, requireMember(), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question || question.length > POLL_QUESTION_MAX) {
      return res.status(400).json({ error: 'INVALID_QUESTION', message: `Ask a question (up to ${POLL_QUESTION_MAX} characters).` });
    }
    const raw = Array.isArray(req.body?.options) ? req.body.options : null;
    const options = raw ? raw.map(o => (typeof o === 'string' ? o.trim() : '')) : [];
    const distinct = new Set(options.map(o => o.toLowerCase()));
    if (!raw || options.length < POLL_OPTIONS_MIN || options.length > POLL_OPTIONS_MAX
      || options.some(o => !o || o.length > POLL_OPTION_MAX) || distinct.size !== options.length) {
      return res.status(400).json({
        error: 'INVALID_OPTIONS',
        message: `Add ${POLL_OPTIONS_MIN} to ${POLL_OPTIONS_MAX} different options (up to ${POLL_OPTION_MAX} characters each).`,
      });
    }
    const poll = await CommunityRepo.createPoll({ community_id: communityId, question, options, created_by: req.user.id });
    const announcement = await CommunityRepo.addMessage({
      community_id: communityId,
      sender_id: req.user.id,
      content: `📊 New Pack Poll: ${question}`,
      message_type: 'system',
    });
    const io = req.app.get('io');
    if (io) {
      io.to(`pawcircle_${communityId}`).emit('community_message_received', announcement);
      io.to(`pawcircle_${communityId}`).emit('community_poll_created', { communityId, poll });
    }
    res.status(201).json({ poll });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/polls/:pollId/vote', rateLimiter(config.RATE_LIMIT.POST), rejectIfFrozen, requireMember(), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const pollId = parseInt(req.params.pollId, 10);
    const { optionIndex } = req.body;
    // votePoll only touches a poll that belongs to THIS circle (null otherwise).
    const updated = Number.isInteger(pollId) ? await CommunityRepo.votePoll(communityId, pollId, req.user.id, optionIndex) : null;
    if (!updated) return res.status(404).json({ error: 'NOT_FOUND', message: 'Poll not found in this PawCircle.' });
    res.json({ poll: updated });
  } catch (err) {
    if (err.code === 'INVALID_OPTION') {
      return res.status(400).json({ error: 'INVALID_OPTION', message: 'That option does not exist on this poll.' });
    }
    sendServerError(res, err);
  }
});

export default router;