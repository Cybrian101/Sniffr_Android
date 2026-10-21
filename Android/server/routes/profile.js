import { Router } from 'express';
import multer from 'multer';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import PetRepo from '../models/PetRepository.js';
import PostRepo from '../models/PostRepository.js';
import UserRepo from '../models/UserRepository.js';
import ProfileViewRepo from '../models/ProfileViewRepository.js';
import { uploadWithQuota } from '../services/mediaService.js';
import config from '../config.js';
import SpotlightRepo from '../models/SpotlightRepository.js';
import db, { withTransaction } from '../db/connection.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { canAddPet, canUseSuperSniff } from '../services/premiumGate.js';
import { sendServerError } from '../utils/errors.js';
import { requirePet } from '../middleware/requirePet.js';
import { isReservedName, RESERVED_NAME_MESSAGE } from '../utils/reservedNames.js';
import { isPetSniffedOut, isUserSniffedOut, SNIFFED_OUT_BODY } from '../utils/sniffedOut.js';

// Pet name / pet username may never be the reserved "SniffedOut" (the name
// deleted pets are shown as). Returns the offending field, or null.
function reservedPetField(body) {
  if (isReservedName(body.name)) return 'name';
  if (isReservedName(body.pet_username)) return 'pet_username';
  return null;
}
import { normalizePetUsername } from '../utils/petUsername.js';
import { toPublicPet } from '../utils/publicPet.js';
import { emitLiveLocation } from '../socket/meet.js';
import { blockState, listBlockedByMe } from '../services/blocks.js';

const router = Router();
router.use(authenticateAccess);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // M9: flag the rejection instead of just `cb(null, false)` -- a bare
    // `false` makes multer silently drop the file with no error at all, so
    // an unsupported type (e.g. HEIC/HEIF, which browsers/iOS can send as
    // the avatar picker's native format) used to just quietly produce a pet
    // with no avatar, or -- worse, once something downstream assumed
    // req.file existed -- throw unexpectedly into a raw 500. receiveAvatar
    // below turns this flag into one clean 400 instead.
    const allowed = [...config.ALLOWED_IMAGE_TYPES, ...config.ALLOWED_VIDEO_TYPES];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    req.avatarTypeRejected = true;
    cb(null, false);
  }
});

// Wraps upload.single('avatar'): turns multer's own rejections (oversized
// file, unsupported type incl. HEIC/HEIF) into a clean 400 instead of
// either a silent no-op or an uncaught error reaching the generic 500
// handler. Same shape as premium.js's receiveProof.
function receiveAvatar(req, res, next) {
  upload.single('avatar')(req, res, err => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'FILE_TOO_LARGE', message: `The photo must be ${Math.round(config.MAX_FILE_SIZE / (1024 * 1024))} MB or smaller.` });
    }
    if (err) return next(err);
    if (req.avatarTypeRejected) {
      return res.status(400).json({ error: 'INVALID_FILE_TYPE', message: 'Avatar must be a JPG, PNG, WEBP or GIF image (or MP4/WEBM video). HEIC/HEIF photos are not supported yet -- please convert or pick a different photo.' });
    }
    next();
  });
}

// ══════════════════════════════════════════════════════════════
// SPECIFIC LITERAL ROUTES FIRST
// (must come before /:id so Express doesn't treat "places-autocomplete",
//  "my-pets", etc. as an :id param and crash with NaN)
// ══════════════════════════════════════════════════════════════

// Google Places Autocomplete (New) — returns predictions as the user types
router.get('/places-autocomplete', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || !q.trim()) return res.json({ results: [] });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      console.warn('[places-autocomplete] GOOGLE_PLACES_API_KEY not set');
      return res.json({ results: [] });
    }

    // Bias toward the requesting user's saved pet location, if available
    const pet = await PetRepo.findByUserId(req.user.id);
    const hasLoc = !!(pet && pet.latitude && pet.longitude);

    const body = {
      input: q,
      includedRegionCodes: ['in'],
    };
    if (hasLoc) {
      body.locationBias = {
        circle: {
          center: { latitude: pet.latitude, longitude: pet.longitude },
          radius: 50000, // 50km bias radius; still allows farther matches, just ranked lower
        },
      };
    }

    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[places-autocomplete] Google error:', response.status, errText);
      return res.json({ results: [] });
    }

    const data = await response.json();
    const suggestions = data.suggestions || [];

    const results = suggestions
      .filter(s => s.placePrediction)
      .map(s => ({
        place_id: s.placePrediction.placeId,
        display_name: s.placePrediction.text?.text || '',
        main_text: s.placePrediction.structuredFormat?.mainText?.text || '',
        secondary_text: s.placePrediction.structuredFormat?.secondaryText?.text || '',
      }));

    res.json({ results });
  } catch (err) {
    console.error('[/places-autocomplete error]', err.message);
    res.json({ results: [] });
  }
});

// Google Place Details (New) — resolves a place_id to exact lat/lng + formatted address
router.get('/place-details', async (req, res) => {
  try {
    const placeId = req.query.place_id;
    if (!placeId) return res.status(400).json({ error: 'MISSING_PLACE_ID' });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      console.warn('[place-details] GOOGLE_PLACES_API_KEY not set');
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Places API not configured' });
    }

    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[place-details] Google error:', response.status, errText);
      return res.status(502).json({ error: 'PLACES_API_ERROR', message: 'Could not resolve place details' });
    }

    const data = await response.json();
    res.json({
      place_id: data.id,
      display_name: data.formattedAddress || data.displayName?.text || '',
      name: data.displayName?.text || '',
      lat: data.location?.latitude,
      lng: data.location?.longitude,
    });
  } catch (err) {
    console.error('[/place-details error]', err.message);
    sendServerError(res, err);
  }
});

router.get('/my-pets', async (req, res) => {
  try {
    const pets = await PetRepo.findAllByUserId(req.user.id);
    const activePet = await PetRepo.getActivePet(req.user.id);
    res.json({ pets, activePet });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/switch-pet', async (req, res) => {
  try {
    const { petId } = req.body;
    if (!petId) return res.status(400).json({ error: 'MISSING_PET_ID', message: 'petId is required' });

    const targetPet = await PetRepo.findById(parseInt(petId, 10));
    if (!targetPet) {
      return res.status(404).json({ error: 'PET_NOT_FOUND', message: 'Pet profile not found' });
    }

    if (targetPet.user_id !== req.user.id) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'You do not own this pet profile' });
    }

    await db.run('UPDATE users SET active_pet_id = ? WHERE id = ?', [targetPet.id, req.user.id]);
    const switchedPet = await PetRepo.getActivePet(req.user.id);
    const allPets = await PetRepo.findAllByUserId(req.user.id);

    res.json({ success: true, pet: switchedPet, allPets });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Blocking (the rule: services/blocks.js) ─────────────────────
// Body: { blockedUserId } -- the OWNER's user id (a pet's user_id); blocking
// is per account. Both answer with the resulting state so the UI can show it.
const toUserId = v => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.post('/block', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const blockedUserId = toUserId(req.body.blockedUserId);
    if (!blockedUserId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'blockedUserId is required' });
    if (req.user.id === blockedUserId) return res.status(400).json({ error: 'CANNOT_BLOCK_SELF', message: 'You cannot block yourself' });
    if (!(await UserRepo.findById(blockedUserId))) {
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }
    // Nothing to block: a SniffedOut account can't reach anyone any more.
    if (await isUserSniffedOut(blockedUserId)) return res.status(403).json(SNIFFED_OUT_BODY);
    await UserRepo.blockUser(req.user.id, blockedUserId);
    // The blocker's other open devices/tabs update too. (Nothing is sent to
    // the blocked user.)
    req.app.get('io')?.to(`user_${req.user.id}`).emit('block_updated', { userId: blockedUserId, blockedByMe: true });
    res.json({ success: true, blockedByMe: true, message: 'User blocked successfully' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/unblock', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const blockedUserId = toUserId(req.body.blockedUserId);
    if (!blockedUserId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'blockedUserId is required' });
    await UserRepo.unblockUser(req.user.id, blockedUserId);
    req.app.get('io')?.to(`user_${req.user.id}`).emit('block_updated', { userId: blockedUserId, blockedByMe: false });
    res.json({ success: true, blockedByMe: false, message: 'User unblocked successfully' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Report a pet's owner from their profile page (ProfilePage.jsx's 3-dot
// menu) -- same post_reports-with-no-conversation pattern as chat.js's
// POST /conversations/:id/report, just resolving the target user directly
// from a userId instead of a conversation partner.
router.post('/report', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const reportedUserId = toUserId(req.body.reportedUserId);
    const { reason, notes } = req.body;
    if (!reportedUserId) return res.status(400).json({ error: 'BAD_REQUEST', message: 'reportedUserId is required' });
    if (!reason) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'A reason is required.' });
    if (req.user.id === reportedUserId) return res.status(400).json({ error: 'CANNOT_REPORT_SELF', message: 'You cannot report yourself' });
    if (!(await UserRepo.findById(reportedUserId))) {
      return res.status(404).json({ error: 'USER_NOT_FOUND' });
    }

    await db.run(
      `INSERT INTO post_reports (user_id, reason, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [req.user.id, `User #${reportedUserId}: ${reason}${notes ? ` - ${notes}` : ''}`]
    );
    res.json({ success: true, message: 'User reported successfully.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Only the people YOU blocked (listing who blocked you would reveal it),
// with a pet to show for each, for Settings > Blocked accounts.
router.get('/blocked', async (req, res) => {
  try {
    const blocked = await listBlockedByMe(req.user.id);
    res.json({ blocked, blockedUserIds: blocked.map(b => b.user_id) });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/location', requirePet, rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const pet = req.pet;

    const latitude = parseFloat(req.body.latitude);
    const longitude = parseFloat(req.body.longitude);
    const accuracy = parseFloat(req.body.accuracy) || null;
    const heading = parseFloat(req.body.heading) || null;
    const speed = parseFloat(req.body.speed) || null;

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: 'INVALID_COORDINATES' });
    }

    const timestamp = new Date().toISOString();
    const updated = await PetRepo.update(pet.id, {
      latitude,
      longitude,
      last_updated_location_timestamp: timestamp
    });

    const io = req.app.get('io');
    if (io) {
      // Only to sockets on the Meet page ('meet_live', see socket/meet.js),
      // and only as each viewer's distance -- never the coordinates.
      emitLiveLocation(io, { pet: updated, latitude, longitude, timestamp });
    }

    res.json({ success: true, pet: updated });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ══════════════════════════════════════════════════════════════
// GENERAL PROFILE ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.json({ pet: null, posts: [] });
    const stats = await PetRepo.getProfileWithStats(pet.id);
    if (stats) {
      const champ = await SpotlightRepo.isChampion(stats.id, stats.latitude, stats.longitude, req.query.cycleStart);
      if (champ) {
        stats.is_champion = true;
        stats.champion_area = champ.area;
      }
    }
    const posts = await PostRepo.getByPetId(pet.id);
    res.json({ pet: stats, posts });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/', receiveAvatar, async (req, res) => {
  try {
    const reservedField = reservedPetField(req.body);
    if (reservedField) {
      return res.status(400).json({ error: 'RESERVED_NAME', field: reservedField, message: RESERVED_NAME_MESSAGE });
    }

    const io = req.app.get('io');
    const petCheck = await canAddPet(req.user.id, io);
    if (!petCheck.allowed) {
      return res.status(403).json({
        error: petCheck.reason,
        message: `Free accounts can have up to ${petCheck.limit} pet profile${petCheck.limit === 1 ? '' : 's'}. Upgrade to Premium for unlimited pets.`,
        plan: petCheck.plan,
        limit: petCheck.limit,
      });
    }

    // Validated before the avatar upload runs -- no point spending a
    // Cloudinary upload on a request that's going to be rejected anyway.
    const usernameResult = normalizePetUsername(req.body.pet_username);
    if (usernameResult.error) {
      return res.status(400).json({ error: usernameResult.error, message: usernameResult.message });
    }

    let avatarUrl = null;
    if (req.file) {
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'avatars');
      avatarUrl = uploaded.url;
    }

    const petData = {
      user_id: req.user.id,
      name: req.body.name,
      pet_username: usernameResult.value,
      type: req.body.type || 'dog',
      gender: req.body.gender || 'male',
      age: parseInt(req.body.age) || 1,
      breed_type: req.body.breed_type || 'Original',
      breed_name: req.body.breed_name || '',
      avatar_url: avatarUrl,
      vaccinated: req.body.vaccinated === 'true' || req.body.vaccinated === true ? 1 : 0,
      pet_kyc: req.body.pet_kyc === 'true' || req.body.pet_kyc === true ? 1 : 0,
      latitude: parseFloat(req.body.latitude) || null,
      longitude: parseFloat(req.body.longitude) || null,
      location_text: req.body.location_text || '',
      country: req.body.country || '',
      state: req.body.state || '',
      city: req.body.city || '',
      area: req.body.area || '',
      bio: req.body.bio || '',
      pawsitive_score: null,
    };

    // canAddPet() above is a fast-path friendly error (avoids the upload
    // above for an obviously-over-limit request) but is a plain
    // check-then-act read with no lock -- two concurrent "add pet"
    // requests could both pass it before either insert lands, letting a
    // free-tier user end up with more pets than their plan allows. This
    // re-checks the count atomically, inside a per-user advisory lock, as
    // the actual enforcement.
    const pet = await withTransaction(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(?)', [req.user.id]);
      const row = await tx.get('SELECT COUNT(*) as count FROM pets WHERE user_id = ?', [req.user.id]);
      if (Number(row.count) >= petCheck.limit) {
        const err = new Error('PET_LIMIT_REACHED');
        err.code = 'PET_LIMIT_REACHED';
        err.limit = petCheck.limit;
        err.plan = petCheck.plan;
        throw err;
      }
      const keys = Object.keys(petData);
      const placeholders = keys.map(() => '?').join(', ');
      const result = await tx.run(
        `INSERT INTO pets (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        Object.values(petData)
      );
      return result.rows[0];
    });

    res.status(201).json(pet);
  } catch (err) {
    if (err.code === 'PET_LIMIT_REACHED') {
      return res.status(403).json({
        error: 'PET_LIMIT_REACHED',
        message: `Free accounts can have up to ${err.limit} pet profile${err.limit === 1 ? '' : 's'}. Upgrade to Premium for unlimited pets.`,
        plan: err.plan,
        limit: err.limit,
      });
    }
    // Postgres unique_violation -- pet_username_key. Raced past the
    // application-level check-then-act (two signups picking the same
    // handle at once), or just never checked availability up front; either
    // way this is the DB's own uniqueness guarantee doing its job, not an
    // unexpected server error.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'That username is already taken. Please choose another.' });
    }
    sendServerError(res, err);
  }
});

router.put('/', requirePet, receiveAvatar, async (req, res) => {
  try {
    const reservedField = reservedPetField(req.body);
    if (reservedField) {
      return res.status(400).json({ error: 'RESERVED_NAME', field: reservedField, message: RESERVED_NAME_MESSAGE });
    }

    // H10: the client now always sends the id of the pet it's actually
    // displaying/editing (ProfilePage.jsx) -- trusting ONLY req.pet (the
    // server's notion of "currently active pet") let a switch-pet race
    // (the new active pet is set server-side before the client's own
    // re-render/reload finishes) silently save an edit, made against the
    // pet the form was showing, onto whichever pet happened to be active
    // the instant this request landed. requirePet's req.pet is kept as the
    // fallback for any other/older caller that doesn't send pet_id.
    let pet = req.pet;
    if (req.body.pet_id !== undefined && req.body.pet_id !== '') {
      const requestedPetId = parseInt(req.body.pet_id, 10);
      if (isNaN(requestedPetId)) return res.status(400).json({ error: 'INVALID_PET_ID' });
      if (requestedPetId !== req.pet.id) {
        const requested = await PetRepo.findById(requestedPetId);
        if (!requested || requested.user_id !== req.user.id || requested.deleted_at) {
          return res.status(403).json({ error: 'NOT_YOUR_PET', message: 'That pet profile does not belong to you.' });
        }
        pet = requested;
      }
    }

    if (req.body.pet_username !== undefined) {
      const usernameResult = normalizePetUsername(req.body.pet_username);
      if (usernameResult.error) {
        return res.status(400).json({ error: usernameResult.error, message: usernameResult.message });
      }
      req.body.pet_username = usernameResult.value;
    }

    const updates = {};
    const fields = ['name', 'pet_username', 'type', 'gender', 'breed_type', 'breed_name', 'bio', 'location_text', 'country', 'state', 'city', 'area'];
    fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (req.body.age) updates.age = parseInt(req.body.age);
    if (req.body.latitude !== undefined && req.body.latitude !== '' && req.body.latitude !== null) updates.latitude = parseFloat(req.body.latitude);
    if (req.body.longitude !== undefined && req.body.longitude !== '' && req.body.longitude !== null) updates.longitude = parseFloat(req.body.longitude);
    if (req.body.vaccinated !== undefined) updates.vaccinated = req.body.vaccinated === 'true' ? 1 : 0;
    if (req.body.pet_kyc !== undefined) updates.pet_kyc = req.body.pet_kyc === 'true' ? 1 : 0;

    if (req.file) {
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'avatars');
      updates.avatar_url = uploaded.url;
    }

    const updated = await PetRepo.update(pet.id, updates);
    const io = req.app.get('io');
    if (io) {
      io.emit('profile_updated', { pet_id: pet.id, pet: toPublicPet(updated) }); // to everyone: no coordinates
    }
    res.json(updated);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'That username is already taken. Please choose another.' });
    }
    sendServerError(res, err);
  }
});

router.patch('/pawsitive', requirePet, async (req, res) => {
  try {
    const pet = req.pet; // requirePet

    const score = parseInt(req.body.score);
    if (isNaN(score) || score < 0 || score > 100) {
      return res.status(400).json({ error: 'INVALID_SCORE', message: 'Score must be 0–100' });
    }

    const updated = await PetRepo.updatePawsitiveScore(pet.id, score);
    const io = req.app.get('io');
    if (io) {
      io.emit('profile_updated', { pet_id: pet.id, pet: toPublicPet(updated) });
    }
    res.json({ success: true, pawsitive_score: updated?.pawsitive_score ?? score });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PATCH /api/profile/super-sniff — toggle stealth browsing (see POST /:id/view)
// Premium-gated: only turning it ON is checked -- a downgraded user must
// always be able to turn it back off regardless of their current plan.
router.patch('/super-sniff', async (req, res) => {
  try {
    const enabled = req.body.enabled === true || req.body.enabled === 'true';

    if (enabled) {
      const io = req.app.get('io');
      const check = await canUseSuperSniff(req.user.id, io);
      if (!check.allowed) {
        return res.status(403).json({ error: check.reason, message: 'Super Sniff is a Premium feature.', plan: check.plan });
      }
    }

    await UserRepo.setSuperSniffStatus(req.user.id, enabled);
    res.json({ success: true, super_sniff_enabled: enabled ? 1 : 0 });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Dynamic /:id route MUST come last ──
router.get('/:id', async (req, res) => {
  try {
    // N4: parseInt + isNaN is not a "fully numeric?" test -- parseInt("7days", 10)
    // returns 7 (it stops at the first non-digit instead of failing), so a
    // digit-leading username like "7days" used to be silently treated as
    // pet #7 instead of falling through to the username lookup below. Only
    // a string that is ENTIRELY digits may be treated as a numeric id.
    const isNumericId = /^\d+$/.test(req.params.id);
    const petId = isNumericId ? parseInt(req.params.id, 10) : NaN;
    // A non-numeric :id segment is a pet_username -- app.sniffrweb.com/kitty
    // (see client/src/App.jsx's top-level catch-all route) hits this exact
    // endpoint with "kitty" instead of a numeric id, so both lookups need
    // to resolve to the same response shape.
    const stats = isNumericId
      ? await PetRepo.getProfileWithStats(petId)
      : await PetRepo.getProfileWithStatsByUsername(req.params.id);
    if (!stats) return res.status(404).json({ error: 'NOT_FOUND' });
    // A SniffedOut pet has no profile to show -- nothing but the flag.
    // (stats.id, not petId: a username URL has no numeric id. A deleted pet's
    // username is cleared, so username URLs never reach one anyway.)
    if (await isPetSniffedOut(stats.id)) return res.json({ sniffed_out: true });

    // Chat, matches, and calls all already enforce blocks (returning 403
    // BLOCKED, the existing convention) -- this route didn't, letting a
    // blocked user view a profile directly via URL/ID even though blocking
    // is meant to stop all contact between the pair.
    // The blocker gets just enough to show "You blocked <name>" with an
    // Unblock button (no posts, stats or details); the blocked user can't
    // see the profile at all.
    if (stats.user_id !== req.user.id) {
      const { blockedByMe, blockedMe } = await blockState(req.user.id, stats.user_id);
      if (blockedByMe) {
        return res.json({
          blocked_by_me: true,
          pet: { id: stats.id, user_id: stats.user_id, name: stats.name, pet_username: stats.pet_username, avatar_url: stats.avatar_url },
          posts: [],
        });
      }
      if (blockedMe) return res.status(403).json({ error: 'BLOCKED', message: 'You cannot view this profile.' });
    }

    const champ = await SpotlightRepo.isChampion(stats.id, stats.latitude, stats.longitude, req.query.cycleStart);
    if (champ) {
      stats.is_champion = true;
      stats.champion_area = champ.area;
    }
    const posts = await PostRepo.getByPetId(stats.id);
    // The owner's own pet keeps its coordinates (the edit form pre-fills
    // them); anyone else never gets them.
    res.json({ pet: stats.user_id === req.user.id ? stats : toPublicPet(stats), posts });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/profile/:id/view — records a profile view and notifies the owner
// (reusing the same sendRealtimeNotification pattern as likes/comments/spotlight).
// Self-views are a silent no-op, and at most one notification fires per
// (viewer pet, viewed pet) pair per rolling 24h -- enforced atomically in
// ProfileViewRepo.claimNotification, not something a client can bypass.
router.post('/:id/view', async (req, res) => {
  try {
    // Same strict-digit guard as GET /:id above (N4) -- parseInt("7days")
    // would otherwise resolve to pet #7 instead of being rejected.
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'INVALID_ID' });
    const viewedPetId = parseInt(req.params.id, 10);

    const viewedPet = await PetRepo.findById(viewedPetId);
    if (!viewedPet) return res.status(404).json({ error: 'NOT_FOUND' });

    // Viewing a SniffedOut pet leaves no trace: no view row, no notification.
    if (await isPetSniffedOut(viewedPetId)) {
      return res.json({ success: true, notified: false, sniffed_out: true });
    }

    if (viewedPet.user_id === req.user.id) {
      return res.json({ success: true, notified: false });
    }

    // A blocked party viewing/being viewed shouldn't trigger a "someone
    // viewed your profile" notification either -- same block enforcement
    // as GET /:id above.
    if (await UserRepo.isBlocked(req.user.id, viewedPet.user_id)) {
      return res.json({ success: true, notified: false });
    }

    // Super Sniff: browse without leaving any trace. This skips the
    // profile_views claim/cooldown write too, not just the notification --
    // so a Super-Sniffed view has zero side effects. If Super Sniff is later
    // turned off, viewing the same profile again starts a fresh 24h window
    // exactly like a first-ever view, instead of silently having spent this
    // pair's notification slot on a view the owner was never told about.
    const viewerUser = await UserRepo.findById(req.user.id);
    if (viewerUser?.super_sniff_enabled) {
      return res.json({ success: true, notified: false });
    }

    const viewerPet = await PetRepo.findByUserId(req.user.id);
    if (!viewerPet) return res.json({ success: true, notified: false });

    const claimed = await ProfileViewRepo.claimNotification(viewerPet.id, viewedPetId);
    if (!claimed) {
      return res.json({ success: true, notified: false });
    }

    // Optional: a "sniff" originating from inside a PawCircle's member list
    // gets community-flavored copy instead of the generic "viewed your
    // profile" text -- same view record either way, just different wording.
    const communityId = parseInt(req.body?.communityId, 10);
    let communityName = null;
    if (!isNaN(communityId)) {
      // Only a member of that circle gets the circle-flavoured text (anyone
      // could otherwise send "X from <any circle> sniffed your profile").
      const community = await db.get(
        `SELECT c.name FROM communities c
         JOIN community_members m ON m.community_id = c.id AND m.user_id = ?
         WHERE c.id = ?`,
        [req.user.id, communityId]);
      communityName = community?.name || null;
    }

    const io = req.app.get('io');
    if (io) {
      await sendRealtimeNotification(io, viewedPet.user_id, communityName ? {
        category: 'pawcircle',
        type: 'profile_sniff',
        title: `👃 ${viewerPet.name} from ${communityName} sniffed your profile!`,
        description: `${viewerPet.name} from ${communityName} sniffed your profile.`,
        avatarUrl: viewerPet.avatar_url || null,
        targetId: String(viewerPet.id),
        senderPetId: viewerPet.id,
        metadata: { community_id: communityId },
      } : {
        category: 'activity',
        type: 'profile_view',
        title: `👀 ${viewerPet.name} viewed your profile!`,
        description: `${viewerPet.name} checked out your profile on Sniffr.`,
        avatarUrl: viewerPet.avatar_url || null,
        targetId: String(viewerPet.id),
        senderPetId: viewerPet.id,
      });
    }

    res.json({ success: true, notified: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;