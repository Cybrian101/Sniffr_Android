import { Router } from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import RatingRepo from '../models/RatingRepository.js';
import { sendServerError } from '../utils/errors.js';

const router = Router();
router.use(authenticateAccess);

// GET /api/ratings -- current aggregate plus the requesting user's own rating
router.get('/', async (req, res) => {
  try {
    const [aggregate, myRating] = await Promise.all([
      RatingRepo.getAggregate(),
      RatingRepo.getMyRating(req.user.id),
    ]);
    res.json({ ...aggregate, myRating });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/ratings { rating: 1-5 } -- creates or updates the caller's own
// rating (one per user, enforced by app_ratings.user_id UNIQUE), then
// broadcasts the new aggregate to every connected client so the number
// everyone sees updates live, not just the person who just rated.
router.post('/', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const rating = parseInt(req.body?.rating, 10);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'INVALID_RATING', message: 'Rating must be a whole number between 1 and 5.' });
    }

    await RatingRepo.upsertRating(req.user.id, rating);
    const aggregate = await RatingRepo.getAggregate();

    const io = req.app.get('io');
    if (io) io.emit('app_rating_updated', aggregate);

    res.json({ success: true, myRating: rating, ...aggregate });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
