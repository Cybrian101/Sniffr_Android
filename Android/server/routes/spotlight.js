import { Router } from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import SpotlightRepo from '../models/SpotlightRepository.js';
import PetRepo from '../models/PetRepository.js';
import { checkAndNotifyAchievement } from '../services/spotlightAchievements.js';
import { sendServerError } from '../utils/errors.js';
import { toPublicPets } from '../utils/publicPet.js';

const router = Router();
router.use(authenticateAccess);
router.use(rateLimiter(config.RATE_LIMIT.GET));

router.get('/', async (req, res) => {
  try {
    const area = req.query.area || 'city';

    // Honest fallback chain: real query params (live GPS from the client) >
    // the requesting user's own saved pet location (real data) > explicit
    // NO_LOCATION -- never a hardcoded coordinate that implies location
    // data which doesn't actually exist. isNaN checks (not `||`) because a
    // real lat of 0 (the equator) is falsy and would otherwise be
    // incorrectly treated as "not provided".
    const queryLat = parseFloat(req.query.lat);
    const queryLng = parseFloat(req.query.lng);
    let lat = !isNaN(queryLat) ? queryLat : null;
    let lng = !isNaN(queryLng) ? queryLng : null;

    if (lat == null || lng == null) {
      const myPet = await PetRepo.findByUserId(req.user.id);
      if (myPet?.latitude && myPet?.longitude) {
        lat = myPet.latitude;
        lng = myPet.longitude;
      }
    }

    if (lat == null || lng == null) {
      return res.json({
        error: 'NO_LOCATION',
        top3: [], ranks4To10: [], ranks11To20: [], risingStars: [],
        nextResetTime: null, lastUpdated: null,
      });
    }

    // M14: the daily reset used to always be UTC midnight here (no
    // cycleStart was ever read on this route) even though ProfilePage.jsx
    // already computes the caller's own browser-local midnight and sends
    // it as cycleStart on GET /profile -- SpotlightPage.jsx now does the
    // same. There's genuinely no "local" to anchor to for the
    // like-triggered background check in spotlightAchievements.js (no
    // browser in that path), which is left on the UTC default.
    const result = await SpotlightRepo.getTopPets(area, lat, lng, req.query.cycleStart);

    // Safety-net check: usually the proactive check triggered by a like
    // (see posts.js) will already have fired by the time anyone visits
    // this page, but this stays as a fallback for any rank change that
    // wasn't caught elsewhere. The atomic claim logic in
    // checkAndNotifyAchievement means this can never create a duplicate
    // even if both paths happen to fire close together.
    const io = req.app.get('io');
    // M14: risingStars duplicates ranks4To10 + ranks11To20 (see
    // SpotlightRepository.getTopPets) -- leaving it out of this flat list
    // is what keeps checkAndNotifyAchievement from notifying rank-4-to-20
    // pets twice about the same event.
    const allRanked = [
      ...(result.top3 || []),
      ...(result.ranks4To10 || []),
      ...(result.ranks11To20 || []),
    ];
    checkAndNotifyAchievement(io, req.user.id, area, allRanked).catch(() => {});

    // The leaderboard holds other users' pets: no coordinates. (A copy --
    // `result` is the cached snapshot.)
    res.json({
      ...result,
      top3: toPublicPets(result.top3),
      ranks4To10: toPublicPets(result.ranks4To10),
      ranks11To20: toPublicPets(result.ranks11To20),
      risingStars: toPublicPets(result.risingStars),
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/history', async (req, res) => {
  try {
    const area = req.query.area || 'city';

    // M14: same fallback chain as GET / above -- without a location, history
    // was effectively a single global list; it's keyed by location_key now
    // (see SpotlightRepository.getHistory), so a location is needed here too.
    const queryLat = parseFloat(req.query.lat);
    const queryLng = parseFloat(req.query.lng);
    let lat = !isNaN(queryLat) ? queryLat : null;
    let lng = !isNaN(queryLng) ? queryLng : null;
    if (lat == null || lng == null) {
      const myPet = await PetRepo.findByUserId(req.user.id);
      if (myPet?.latitude && myPet?.longitude) {
        lat = myPet.latitude;
        lng = myPet.longitude;
      }
    }

    const result = await SpotlightRepo.getHistory(area, lat, lng);
    res.json({ history: result });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;