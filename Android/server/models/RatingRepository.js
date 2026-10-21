import BaseRepository from './BaseRepository.js';
import db from '../db/connection.js';

class RatingRepository extends BaseRepository {
  constructor() { super('app_ratings'); }

  // One row per user, enforced by the UNIQUE constraint on user_id -- a
  // second submission updates the existing row (with a fresh updated_at)
  // instead of creating a duplicate, which is also what keeps the aggregate
  // honest (each user counts once, latest opinion wins).
  async upsertRating(userId, rating) {
    const result = await db.run(
      `INSERT INTO app_ratings (user_id, rating)
       VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE
       SET rating = EXCLUDED.rating, updated_at = NOW()
       RETURNING *`,
      [userId, rating]
    );
    return result.rows[0];
  }

  async getMyRating(userId) {
    const row = await db.get('SELECT rating FROM app_ratings WHERE user_id = ?', [userId]);
    return row ? row.rating : null;
  }

  async getAggregate() {
    const row = await db.get('SELECT COUNT(*)::int as count, AVG(rating)::float as average FROM app_ratings');
    return {
      count: row?.count || 0,
      average: row?.average != null ? Math.round(row.average * 10) / 10 : 0,
    };
  }
}

export default new RatingRepository();
