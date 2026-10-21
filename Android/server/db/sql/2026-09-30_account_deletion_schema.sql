-- Account deletion ("SniffedOut") -- schema parts A, B, C, D and F.
--
-- Run by hand in the Supabase SQL editor. Additive only: new tables, new
-- nullable/defaulted columns, new indexes and constraints -- nothing the
-- currently deployed code reads or writes changes meaning. Safe to run twice.
--
-- Part E (payment_sessions / plan_history user_id FK -> ON DELETE RESTRICT)
-- is intentionally NOT here: it ships together with the deploy of the new
-- deletion code, never before it.
--
-- Id types match the live schema: users.id, pets.id and communities.id are
-- all INTEGER.

BEGIN;

-- Fail fast rather than queue behind live traffic: the ALTER TABLEs below
-- briefly need an exclusive lock on users, pets and communities.
SET LOCAL lock_timeout = '5s';

-- ── A. Email verification codes (delete-account confirmation) ──────────
-- One row per code sent. Only an HMAC of the code is stored; attempts,
-- expiry and single use are tracked in the row itself.
CREATE TABLE IF NOT EXISTS public.verification_codes (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  purpose        TEXT NOT NULL
                 CONSTRAINT verification_codes_purpose_check CHECK (purpose IN ('delete_account')),
  code_hash      TEXT NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_verification_codes_user_purpose
  ON public.verification_codes (user_id, purpose, created_at DESC);

-- ── B. Cloudinary purge queue ──────────────────────────────────────────
-- Filled inside the deletion transaction, purged after commit, retried
-- hourly. No FK to users on purpose. source: 'posts' | 'avatars' | 'chat' |
-- 'community_media' | 'community_photos' | 'media_files'.
CREATE TABLE IF NOT EXISTS public.pending_media_deletions (
  id              BIGSERIAL PRIMARY KEY,
  public_id       TEXT NOT NULL,
  resource_type   TEXT NOT NULL
                  CONSTRAINT pending_media_deletions_resource_type_check CHECK (resource_type IN ('image', 'video', 'raw')),
  source          TEXT NOT NULL,
  deleted_user_id INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pending_media_deletions_public_id_resource_type_key UNIQUE (public_id, resource_type)
);

-- ── C. Tombstone markers ───────────────────────────────────────────────
-- NULL = live account / pet. Set when an account is SniffedOut.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.pets  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Nearby / Meet lookups will filter on live pets only.
CREATE INDEX IF NOT EXISTS idx_pets_active_geo
  ON public.pets (latitude, longitude) WHERE deleted_at IS NULL;

-- ── D. Frozen (read-only) PawCircles ───────────────────────────────────
-- Every existing circle becomes 'active' via the default. frozen_reason is
-- 'owner_deleted' when the owner's account is SniffedOut.
ALTER TABLE public.communities ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE public.communities ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
ALTER TABLE public.communities ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'communities_status_check' AND conrelid = 'public.communities'::regclass
  ) THEN
    ALTER TABLE public.communities
      ADD CONSTRAINT communities_status_check CHECK (status IN ('active', 'frozen'));
  END IF;
END $$;

-- ── F. PawCircle ownership transfers (hook for a future feature) ───────
-- No endpoints use this yet. A transfer is valid for 5 days from when it
-- was sent; if the owner deletes their account meanwhile and the recipient
-- accepts in time, the frozen circle is reactivated under them.
CREATE TABLE IF NOT EXISTS public.community_ownership_transfers (
  id           SERIAL PRIMARY KEY,
  community_id INTEGER NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  from_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  to_user_id   INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
               CONSTRAINT community_ownership_transfers_status_check
               CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 days'),
  responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_one_pending
  ON public.community_ownership_transfers (community_id) WHERE status = 'pending';

-- ── Keep the new tables out of Supabase's public REST API ──────────────
-- RLS with no policies blocks the anon/authenticated roles. The server
-- connects as the tables' owner (postgres), which RLS does not apply to.
ALTER TABLE public.verification_codes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_media_deletions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_ownership_transfers ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ── Verification (read-only; one result set so the SQL editor shows it all)
-- Expect: 3 tables 'exists'; 26 columns on the new tables (9 + 9 + 8) plus
-- users.deleted_at, pets.deleted_at and communities status / frozen_at /
-- frozen_reason; the CHECK / FK / UNIQUE constraints; 3 indexes; RLS
-- 'enabled' x3; and every existing circle counted under 'active'.
SELECT 'table' AS kind, t AS object,
       CASE WHEN to_regclass('public.' || t) IS NOT NULL THEN 'exists' ELSE 'MISSING' END AS detail
FROM unnest(ARRAY['verification_codes', 'pending_media_deletions', 'community_ownership_transfers']) AS t
UNION ALL
SELECT 'column', table_name || '.' || column_name,
       data_type || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
                 || COALESCE(' DEFAULT ' || column_default, '')
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (   table_name IN ('verification_codes', 'pending_media_deletions', 'community_ownership_transfers')
       OR (table_name IN ('users', 'pets') AND column_name = 'deleted_at')
       OR (table_name = 'communities' AND column_name IN ('status', 'frozen_at', 'frozen_reason')))
UNION ALL
SELECT 'constraint', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid)
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
WHERE c.relnamespace = 'public'::regnamespace
  AND (   c.relname IN ('verification_codes', 'pending_media_deletions', 'community_ownership_transfers')
       OR con.conname = 'communities_status_check')
UNION ALL
SELECT 'index', tablename || '.' || indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('idx_verification_codes_user_purpose', 'idx_pets_active_geo', 'uq_transfer_one_pending')
UNION ALL
SELECT 'rls', relname, CASE WHEN relrowsecurity THEN 'enabled' ELSE 'DISABLED' END
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('verification_codes', 'pending_media_deletions', 'community_ownership_transfers')
UNION ALL
SELECT 'data', 'communities.status = ' || status, count(*)::text || ' circle(s)'
FROM public.communities
GROUP BY status
ORDER BY 1, 2;
