import SpotlightRepo from '../models/SpotlightRepository.js';
import PetRepo from '../models/PetRepository.js';
import db from '../db/connection.js';
import { sendRealtimeNotification } from '../socket/notifications.js';

const SPOTLIGHT_AREAS = ['locality', 'city', 'country', 'region'];

// ── Atomic check-and-claim for a rank improvement ─────────────────
// A single UPSERT with a WHERE clause: Postgres serializes concurrent
// writes to the same (pet_id, area) row, so even if this gets called
// from two different triggers close together (e.g. a like AND a page
// visit landing at nearly the same moment), only one can ever succeed
// in claiming the improvement -- the other gets zero rows back and
// correctly does nothing. This is what prevents duplicate notifications.
async function tryClaimRankImprovement(petId, area, newRank) {
  const result = await db.run(
    `INSERT INTO spotlight_rank_tracking (pet_id, area, last_notified_rank, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (pet_id, area) DO UPDATE
       SET last_notified_rank = EXCLUDED.last_notified_rank, updated_at = CURRENT_TIMESTAMP
       WHERE spotlight_rank_tracking.last_notified_rank IS NULL
          OR spotlight_rank_tracking.last_notified_rank > EXCLUDED.last_notified_rank
     RETURNING *`,
    [petId, area, newRank]
  );
  return result && result.rows && result.rows.length > 0;
}

export async function checkAndNotifyAchievement(io, userId, area, allRankedPets) {
  if (!io) {
    console.log(`[spotlight:${area}] checkAndNotifyAchievement skipped -- no io instance`);
    return;
  }
  try {
    const myPet = await PetRepo.findByUserId(userId);
    if (!myPet) {
      console.log(`[spotlight:${area}] checkAndNotifyAchievement skipped -- no active pet for user_id=${userId}`);
      return;
    }
    if (myPet.deleted_at) return; // deleted pets are never ranked or announced

    const myRankedInfo = allRankedPets.find(p => p.id === myPet.id);
    if (!myRankedInfo || !myRankedInfo.rank) {
      console.log(`[spotlight:${area}] pet_id=${myPet.id} not present in ranked list (${allRankedPets.length} ranked pets) -- no rank to claim`);
      return;
    }

    const rank = myRankedInfo.rank;
    console.log(`[spotlight:${area}] pet_id=${myPet.id} rank=${rank} -- attempting claim`);
    const claimed = await tryClaimRankImprovement(myPet.id, area, rank);
    if (!claimed) {
      console.log(`[spotlight:${area}] pet_id=${myPet.id} rank=${rank} -- claim skipped (already notified at this rank or better)`);
      return;
    }
    console.log(`[spotlight:${area}] pet_id=${myPet.id} rank=${rank} -- claim WON, sending notification`);

    let title = '';
    if (rank === 1) {
      title = `👑 You are now #1 in ${area} Spotlight!`;
    } else if (rank <= 5) {
      title = `🥈 You are now #${rank} in ${area} Spotlight!`;
    } else if (rank <= 10) {
      title = `🎉 You reached Top 10 in ${area} Spotlight!`;
    } else if (rank <= 20) {
      title = `🐾 You reached Top 20 in ${area} Spotlight!`;
    } else {
      return;
    }

    await sendRealtimeNotification(io, userId, {
      category: 'activity',
      type: 'spotlight_achievement',
      title,
      description: `You moved up in the ${area} leaderboard. Keep it up! 🏆`,
      avatarUrl: myPet.avatar_url || null,
      targetId: String(myPet.id),
      senderPetId: myPet.id,
    });

    if (rank === 1) {
      for (const otherPet of allRankedPets) {
        if (otherPet.id === myPet.id) continue;
        try {
          const otherPetFull = await PetRepo.findById(otherPet.id);
          if (!otherPetFull || !otherPetFull.user_id || otherPetFull.deleted_at) continue;
          await sendRealtimeNotification(io, otherPetFull.user_id, {
            category: 'activity',
            type: 'spotlight_new_champion',
            title: `🏆 ${myPet.name} is now #1 in ${area} Spotlight!`,
            description: `${myPet.name} just took the top spot. Keep licking to catch up! 🐾`,
            avatarUrl: myPet.avatar_url || null,
            targetId: String(myPet.id),
            senderPetId: myPet.id,
          });
        } catch (innerErr) {
          console.error('[checkAndNotifyAchievement broadcast error]', innerErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[checkAndNotifyAchievement error]', err.message);
  }
}

// ── Proactive check, triggered immediately by a like (not by a page visit) ──
// Checks the given pet's rank across ALL area types right now, since a
// single like could move them up in their locality, city, country, and
// region rankings simultaneously. Called from posts.js right after a
// like succeeds, so the notification arrives the moment the rank
// actually changes -- not whenever someone next happens to open Spotlight.
export async function checkSpotlightAchievementsForPet(io, petId) {
  console.log(`[checkSpotlightAchievementsForPet] called for petId=${petId}, io=${!!io}`);
  if (!io || !petId) {
    console.log(`[checkSpotlightAchievementsForPet] aborted -- missing io or petId (io=${!!io}, petId=${petId})`);
    return;
  }
  try {
    const pet = await PetRepo.findById(petId);
    if (!pet || !pet.user_id) {
      console.log(`[checkSpotlightAchievementsForPet] pet lookup failed for petId=${petId} (pet found=${!!pet}, user_id=${pet?.user_id})`);
      return;
    }
    if (pet.deleted_at) return; // deleted pets are never ranked or announced
    console.log(`[checkSpotlightAchievementsForPet] pet found: id=${pet.id} name=${pet.name} user_id=${pet.user_id} lat=${pet.latitude} lng=${pet.longitude}`);
    if (pet.latitude == null || pet.longitude == null) {
      console.warn(`[checkSpotlightAchievementsForPet] pet_id=${pet.id} has no latitude/longitude -- SpotlightRepo.getTopPets excludes pets with null coordinates, so this pet can NEVER be ranked or notified until location is set`);
    }

    for (const area of SPOTLIGHT_AREAS) {
      try {
        const result = await SpotlightRepo.getTopPets(area, pet.latitude, pet.longitude);
        // M14: risingStars (ranks 4-20) is the SAME pets as ranks4To10 +
        // ranks11To20 combined -- SpotlightRepository keeps it only as a
        // convenience shape for the client. Including it here too meant
        // every rank-4-to-20 pet appeared twice in allRankedPets, so
        // checkAndNotifyAchievement's "tell everyone a new champion just
        // took #1" loop emailed/notified them twice for one event.
        const allRanked = [
          ...(result.top3 || []),
          ...(result.ranks4To10 || []),
          ...(result.ranks11To20 || []),
        ];
        console.log(`[checkSpotlightAchievementsForPet:${area}] ${allRanked.length} ranked pets returned`);
        await checkAndNotifyAchievement(io, pet.user_id, area, allRanked);
      } catch (areaErr) {
        console.error(`[checkSpotlightAchievementsForPet:${area}] ERROR`, areaErr);
      }
    }
  } catch (err) {
    console.error('[checkSpotlightAchievementsForPet error]', err);
  }
}