import BaseRepository from './BaseRepository.js';
import db from '../db/connection.js';

class ProfileViewRepository extends BaseRepository {
  constructor() { super('profile_views'); }

  /**
   * Atomic claim for the 24h "one profile-view notification per (viewer,
   * viewed) pair" rule -- same INSERT ... ON CONFLICT ... DO UPDATE ... WHERE
   * pattern as spotlightAchievements.js's tryClaimRankImprovement. A single
   * round trip either wins the claim (row inserted / stale row refreshed) or
   * loses it (row exists and is still within the 24h window), so the check
   * can't be bypassed or raced by the client.
   */
  async claimNotification(viewerPetId, viewedPetId) {
    const result = await db.run(
      `INSERT INTO profile_views (viewer_pet_id, viewed_pet_id, last_notified_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (viewer_pet_id, viewed_pet_id) DO UPDATE
         SET last_notified_at = CURRENT_TIMESTAMP
         WHERE profile_views.last_notified_at < NOW() - INTERVAL '24 hours'
       RETURNING *`,
      [viewerPetId, viewedPetId]
    );
    return result && result.rows && result.rows.length > 0;
  }
}

export default new ProfileViewRepository();
