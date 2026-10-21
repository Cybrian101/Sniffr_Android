-- Spotlight QA handoff fixes: M14 ("yesterday's champion history is global
-- rather than location-specific") and M15 ("Spotlight Boosts are sold but
-- do not provide the promised effect").
--
-- Run by hand in the Supabase SQL editor, BEFORE deploying the backend
-- change that reads/writes these (server/models/SpotlightRepository.js,
-- server/services/premiumGate.js). Additive and idempotent: safe to run
-- twice.

-- M14: spotlight_history's UNIQUE(area, cycle_date) meant only ONE row
-- could ever exist per area per day, GLOBALLY -- whichever user anywhere on
-- the planet happened to trigger the lazy history-save first "won" that
-- day's locality/city/country/region champion for every other user
-- everywhere else, regardless of their own actual area. location_key scopes
-- it to the same coarse grid cell SpotlightRepository's leaderboard cache
-- already buckets by (see CACHE_GRID_DEGREES), so it now matches "yesterday's
-- champion near me," not "yesterday's champion for whoever saved first."
ALTER TABLE public.spotlight_history ADD COLUMN IF NOT EXISTS location_key TEXT NOT NULL DEFAULT 'global';

ALTER TABLE public.spotlight_history DROP CONSTRAINT IF EXISTS spotlight_history_area_cycle_date_key;
ALTER TABLE public.spotlight_history
  ADD CONSTRAINT spotlight_history_area_location_cycle_date_key UNIQUE (area, location_key, cycle_date);

CREATE INDEX IF NOT EXISTS idx_spotlight_history_area_location
  ON public.spotlight_history (area, location_key, cycle_date DESC);

-- M15: a purchased Spotlight Boost (users.boost_credits_remaining, spent via
-- POST /api/premium/boost/use) previously only decremented a credit counter
-- -- nothing recorded that a boost was ACTIVE, so the ranking query had
-- nothing to read even if it wanted to apply an effect.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS spotlight_boost_until TIMESTAMPTZ;

-- ── Verification (read-only) ──────────────────────────────────────────
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'spotlight_history' AND column_name = 'location_key'
UNION ALL
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'spotlight_boost_until';
