import db from '../db/connection.js';
import config from '../config.js';
import PetRepository from './PetRepository.js';
import { sqlPetName, sqlHidden, sqlGone } from '../utils/sniffedOut.js';

let cache = {}; // cacheKey -> { data, dateStr, computedAt }
let previousRanks = {}; // cacheKey -> { petId -> rank }

// H14: a cache key built from the raw GPS float (e.g. 13.082731984...) is
// effectively unique per caller, so two people standing a few meters apart
// -- or the same person's GPS drifting slightly between requests -- almost
// never share a cache entry. Rounded to a grid roughly the size of the
// area's own radius: anyone whose query point falls in the same cell reuses
// the same leaderboard, which is exactly correct since they'd get the same
// ranked set either way (same center-independent radius query result for
// points this close together, in practice).
const CACHE_GRID_DEGREES = { locality: 0.25, city: 0.75, country: 5, region: 15 };
function cacheRound(value, area) {
  const grid = CACHE_GRID_DEGREES[area] || 0.75;
  return Math.round(value / grid) * grid;
}

// Same grid cell concept, for spotlight_history (M14) -- a stable string
// key instead of the in-memory cache's object key, so two query points in
// the same cell agree on which "yesterday's champion" row is theirs.
function locationKeyFor(area, lat, lng) {
  if (lat == null || lng == null) return 'global';
  return `${cacheRound(lat, area).toFixed(2)},${cacheRound(lng, area).toFixed(2)}`;
}

class SpotlightRepository {
  async getTopPets(area, lat, lng, clientCycleStart = null) {
    // Current date string for daily 00:00 freeze (e.g. "2026-07-24").
    // clientCycleStart (the caller's own local midnight, computed
    // client-side -- see ProfilePage.jsx/SpotlightPage.jsx) is preferred;
    // the UTC fallback below only applies when no caller-supplied value is
    // available (M14 -- see routes/spotlight.js and
    // services/spotlightAchievements.js for which call sites can/can't
    // supply one, and why).
    const now = new Date();
    const todayDateStr = clientCycleStart
      ? clientCycleStart.split('T')[0]
      : now.toISOString().split('T')[0];

    const cacheKey = lat != null && lng != null
      ? `${area}_${cacheRound(lat, area)}_${cacheRound(lng, area)}_${todayDateStr}`
      : `${area}_none_${todayDateStr}`;

    // Return the cached leaderboard if it's for today AND still fresh
    // (SPOTLIGHT_CACHE_TTL) -- minus any pet deleted since it was cached.
    // H14: this used to be frozen for the whole day and only ever busted by
    // a blanket SpotlightRepo.clearCache() call on every single like
    // anywhere in the app (removed, see routes/posts.js), which discarded
    // every area/location's cache platform-wide for one pet's rank change.
    // A short TTL gives the same "feels live" effect at a fraction of the
    // cost: a cache key naturally goes stale on its own after
    // SPOTLIGHT_CACHE_TTL instead of needing to be told to.
    const fresh = cache[cacheKey] && cache[cacheKey].dateStr === todayDateStr
      && (Date.now() - cache[cacheKey].computedAt) < config.SPOTLIGHT_CACHE_TTL;
    if (fresh) {
      cache[cacheKey].data = await this.withoutDeletedPets(cache[cacheKey].data);
      return cache[cacheKey].data;
    }

    let radiusKm;
    switch (area) {
      case 'locality': radiusKm = 50; break;
      case 'city': radiusKm = 150; break;
      case 'country': radiusKm = 1500; break;
      case 'region': radiusKm = 5000; break;
      default: radiusKm = 150;
    }

    // Check and lazily write yesterday's history snapshot
    await this.checkAndSaveHistory(area, lat, lng, todayDateStr);

    // Query all pets with Total Profile Licks & latest lick timestamp for tie-breaking
    // Total Licks = Profile Swipes Received (likes/superlikes) + Post Likes Received
    // spotlight_boost_until: M15 -- a purchased Spotlight Boost (see
    // premiumGate.consumeBoostCredit) used to only decrement a credit
    // counter with no effect on ranking at all. An active boost (until this
    // timestamp passes) now guarantees top-of-leaderboard placement -- see
    // the sort below.
    const allPets = await db.all(`
      SELECT p.*, u.username, u.spotlight_boost_until,
        (
          (SELECT COUNT(*) FROM swipes s WHERE s.to_pet_id = p.id AND s.action IN ('like', 'superlike')) +
          (SELECT COUNT(*) FROM likes l JOIN posts po ON l.post_id = po.id WHERE po.pet_id = p.id AND po.is_flagged = 0)
        ) as total_licks,
        (
          SELECT COALESCE(
            MAX(s.created_at),
            (SELECT MAX(l.created_at) FROM likes l JOIN posts po ON l.post_id = po.id WHERE po.pet_id = p.id)
          ) FROM swipes s WHERE s.to_pet_id = p.id AND s.action IN ('like', 'superlike')
        ) as last_lick_time
      FROM pets p
      JOIN users u ON p.user_id = u.id
      WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
        AND p.is_flagged = 0
        AND p.deleted_at IS NULL AND u.deleted_at IS NULL
    `);

    // Filter by distance
    let filtered = lat && lng ? allPets.filter(pet => {
      const dist = haversine(lat, lng, pet.latitude, pet.longitude);
      return dist <= radiusKm;
    }) : allPets;

    // ── Deterministic Ranking Logic ─────────────────────────────────
    // 0. Boosted-and-currently-active pets first, as a group (M15).
    // 1. Primary: Total Licks descending
    // 2. Tie-break: Earliest last_lick_time (the profile that reached the lick count FIRST ranks higher)
    // 3. Fallback: Earliest pet ID
    // total_licks/timestamps are explicitly Number()/getTime()-coerced with
    // an isNaN fallback to 0 throughout (M14) -- node-pg returns COUNT(*)'s
    // bigint result as a numeric STRING, not a number, and an unparseable
    // or missing timestamp must never silently produce a NaN that corrupts
    // comparator ordering (Array.prototype.sort has no defined behavior
    // once a comparator can return NaN).
    const nowMs = Date.now();
    const isBoosted = pet => !!pet.spotlight_boost_until && new Date(pet.spotlight_boost_until).getTime() > nowMs;
    const safeTicks = v => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const lickTime = v => {
      if (!v) return 0;
      const t = new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')).getTime();
      return Number.isFinite(t) ? t : 0;
    };

    filtered.sort((a, b) => {
      const aBoosted = isBoosted(a), bBoosted = isBoosted(b);
      if (aBoosted !== bBoosted) return aBoosted ? -1 : 1;

      const aTicks = safeTicks(a.total_licks), bTicks = safeTicks(b.total_licks);
      if (bTicks !== aTicks) return bTicks - aTicks;

      const aTime = lickTime(a.last_lick_time), bTime = lickTime(b.last_lick_time);
      if (aTime !== bTime) {
        if (aTime === 0) return 1;
        if (bTime === 0) return -1;
        return aTime - bTime; // Earliest timestamp first
      }

      return a.id - b.id;
    });

    // Limit to Top 20 highest-ranked profiles (no duplicates) BEFORE the
    // expensive per-pet stats attachment below -- H14: attachCompletionStats
    // runs 2 more queries per pet (gallery post count + owner premium
    // lookup), so running it on every candidate within a potentially huge
    // radius (region = 5000km) was 2 extra queries per pet IN RANGE, not
    // per pet actually shown. Only the 20 pets that make the cut need it.
    const top20Raw = filtered.slice(0, 20);
    const top20Candidates = await Promise.all(top20Raw.map(async pet => {
      const petWithStats = await PetRepository.attachCompletionStats(pet);
      return {
        ...petWithStats,
        total_licks: safeTicks(pet.total_licks),
        last_lick_time: pet.last_lick_time || null,
        is_boosted: isBoosted(pet),
      };
    }));

    const prevRankMap = previousRanks[cacheKey];
    const newRankMap = {};

    const rankedPets = top20Candidates.map((pet, idx) => {
      const currentRank = idx + 1;
      newRankMap[pet.id] = currentRank;

      let movement = null;
      if (prevRankMap) {
        if (pet.id in prevRankMap) {
          const prevRank = prevRankMap[pet.id];
          if (currentRank < prevRank) {
            movement = { type: 'up', value: prevRank - currentRank };
          } else if (currentRank > prevRank) {
            movement = { type: 'down', value: currentRank - prevRank };
          }
        } else {
          movement = { type: 'new' };
        }
      }

      return {
        ...pet,
        rank: currentRank,
        is_champion: currentRank === 1,
        movement
      };
    });

    previousRanks[cacheKey] = newRankMap;

    // Next reset time at tomorrow 00:00:00
    const nextReset = new Date();
    nextReset.setHours(24, 0, 0, 0);

    const result = {
      top3: rankedPets.slice(0, 3),
      ranks4To10: rankedPets.slice(3, 10),
      ranks11To20: rankedPets.slice(10, 20),
      risingStars: rankedPets.slice(3, 20), // Top 4 to 20 for backward compatibility
      nextResetTime: nextReset.toISOString(),
      lastUpdated: new Date().toISOString()
    };

    // Cache this area/location bucket's snapshot (TTL'd, see the read above)
    cache[cacheKey] = { data: result, dateStr: todayDateStr, computedAt: Date.now() };
    return result;
  }

  // The daily board is frozen at first calculation, so a pet deleted (or
  // removed) later in the day would otherwise stay on it until midnight.
  // Keeps the frozen scores and order, drops pets that are no longer live,
  // and renumbers the rest.
  async withoutDeletedPets(result) {
    const ranked = [...(result.top3 || []), ...(result.ranks4To10 || []), ...(result.ranks11To20 || [])];
    if (!ranked.length) return result;

    const live = await db.all(
      `SELECT p.id FROM pets p JOIN users u ON u.id = p.user_id
       WHERE p.id = ANY(?::int[]) AND p.deleted_at IS NULL AND u.deleted_at IS NULL`,
      [ranked.map(p => p.id)]
    );
    if (live.length === ranked.length) return result;

    const liveIds = new Set(live.map(r => r.id));
    const kept = ranked
      .filter(p => liveIds.has(p.id))
      .map((p, idx) => ({ ...p, rank: idx + 1, is_champion: idx === 0 }));
    return {
      ...result,
      top3: kept.slice(0, 3),
      ranks4To10: kept.slice(3, 10),
      ranks11To20: kept.slice(10, 20),
      risingStars: kept.slice(3, 20),
    };
  }

  async checkAndSaveHistory(area, lat, lng, todayDateStr) {
    try {
      // Calculate yesterday date string
      const todayDate = new Date(todayDateStr);
      const yesterday = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
      const cycleDateStr = yesterday.toISOString().split('T')[0];

      // M14: scoped to the same coarse location grid cell as the
      // leaderboard cache (see locationKeyFor) -- WITHOUT this, the unique
      // constraint was (area, cycle_date) only, so there could only ever be
      // ONE "yesterday's city champion" row PER DAY, GLOBALLY: whichever
      // user anywhere on the planet happened to trigger this lazy save
      // first "won" that slot for every other city on Earth.
      const locationKey = locationKeyFor(area, lat, lng);

      // Check if history record exists for yesterday, for this location.
      const existing = await db.get(
        'SELECT id FROM spotlight_history WHERE area = ? AND location_key = ? AND cycle_date = ?',
        [area, locationKey, cycleDateStr]
      );
      if (existing) return;

      let radiusKm;
      switch (area) {
        case 'locality': radiusKm = 50; break;
        case 'city': radiusKm = 150; break;
        case 'country': radiusKm = 1500; break;
        case 'region': radiusKm = 5000; break;
        default: radiusKm = 150;
      }

      const allPets = await db.all(`
        SELECT p.id, p.latitude, p.longitude,
          (
            (SELECT COUNT(*) FROM swipes s WHERE s.to_pet_id = p.id AND s.action IN ('like', 'superlike')) +
            (SELECT COUNT(*) FROM likes l JOIN posts po ON l.post_id = po.id WHERE po.pet_id = p.id AND po.is_flagged = 0)
          ) as total_licks
        FROM pets p
        WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
          AND p.is_flagged = 0
          AND p.deleted_at IS NULL
      `);

      const filtered = lat && lng ? allPets.filter(pet => {
        const dist = haversine(lat, lng, pet.latitude, pet.longitude);
        return dist <= radiusKm;
      }) : allPets;

      if (filtered.length === 0) return;

      // M14: Number()-coerced with a finite fallback -- node-pg returns
      // this bigint SUM as a numeric string, and an unparseable value must
      // never let the comparator return NaN (see the identical guard in
      // getTopPets above).
      const ticks = p => { const n = Number(p.total_licks); return Number.isFinite(n) ? n : 0; };
      filtered.sort((a, b) => ticks(b) - ticks(a));

      const champion = filtered[0];
      const championTicks = ticks(champion);
      if (champion && championTicks > 0) {
        await db.run(
          `INSERT INTO spotlight_history (pet_id, area, location_key, score, cycle_date)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (area, location_key, cycle_date) DO NOTHING`,
          [champion.id, area, locationKey, Math.round(championTicks), cycleDateStr]
        );
      }
    } catch (e) {
      console.error('Error saving lazy spotlight history:', e.message);
    }
  }

  // Past winners are deliberately NOT filtered: a deleted pet's old wins
  // stay on the history list (shown as "SniffedOut"). M14: scoped to the
  // caller's own location_key -- see checkAndSaveHistory.
  async getHistory(area, lat = null, lng = null) {
    const locationKey = locationKeyFor(area, lat, lng);
    const history = await db.all(`
      SELECT h.*, ${sqlPetName('p', 'u')} as name, ${sqlHidden('p.pet_username', 'p', 'u')} as pet_username,
        ${sqlHidden('p.avatar_url', 'p', 'u')} as avatar_url, ${sqlHidden('p.breed_name', 'p', 'u')} as breed_name,
        ${sqlGone('p', 'u')} as sniffed_out
      FROM spotlight_history h
      JOIN pets p ON h.pet_id = p.id
      LEFT JOIN users u ON u.id = p.user_id
      WHERE h.area = ? AND h.location_key = ?
      ORDER BY h.cycle_date DESC
      LIMIT 30
    `, [area, locationKey]);
    return history;
  }

  async isChampion(petId, lat, lng, clientCycleStart = null) {
    if (!lat || !lng) return null;
    const areas = ['locality', 'city', 'country', 'region'];
    for (const area of areas) {
      const result = await this.getTopPets(area, lat, lng, clientCycleStart);
      if (result.top3?.[0]?.id === petId) {
        return { is_champion: true, area };
      }
    }
    return null;
  }

  clearCache() {
    cache = {};
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

export default new SpotlightRepository();