-- Private PawCircles: joining by approval (requests the Owner/Admins accept).
--
-- Run by hand in the Supabase SQL editor, BEFORE deploying the backend that
-- uses it (join requests, search, circle details and the hourly expiry all
-- read these columns). Additive and idempotent: safe to run twice.
--
-- community_join_requests (already exists, RLS already on, unused so far):
--   expires_at   a pending request lapses 7 days after it was sent
--   decided_at   when it was accepted / declined / cancelled / expired
--                (a decline blocks a new request for 24 hours from this)
--   decided_by   the Owner/Admin who accepted or declined it
--   status       pending | accepted | declined | cancelled | expired
-- communities.disabled_at: "Disable PawCircle" used to set is_private = 1;
--   is_private now means "private, join by approval", so disabling gets its
--   own column. (Production has no circles yet, so nothing to convert.)

BEGIN;

ALTER TABLE public.community_join_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE public.community_join_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE public.community_join_requests ADD COLUMN IF NOT EXISTS decided_by INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_join_requests_decided_by_fkey') THEN
    ALTER TABLE public.community_join_requests
      ADD CONSTRAINT community_join_requests_decided_by_fkey
      FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Rows written before this change (none today) get a 7-day window and a status.
UPDATE public.community_join_requests SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL;
UPDATE public.community_join_requests SET status = 'pending' WHERE status IS NULL;
ALTER TABLE public.community_join_requests ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE public.community_join_requests ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_join_requests_status_check') THEN
    ALTER TABLE public.community_join_requests
      ADD CONSTRAINT community_join_requests_status_check
      CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired'));
  END IF;
END $$;

-- The Requests list (pending per circle) and the hourly expiry.
CREATE INDEX IF NOT EXISTS idx_community_join_requests_pending
  ON public.community_join_requests (community_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_community_join_requests_expiry
  ON public.community_join_requests (expires_at) WHERE status = 'pending';

-- Already enabled; repeated so the table can never be left without it.
ALTER TABLE public.community_join_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.communities ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

COMMIT;

-- ── Verification (read-only) ──────────────────────────────────────────
-- Expect 5 rows: decided_at, decided_by, disabled_at, expires_at, status (NO).
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'community_join_requests' AND column_name IN ('expires_at', 'decided_at', 'decided_by', 'status'))
    OR (table_name = 'communities' AND column_name = 'disabled_at'))
ORDER BY column_name;
-- Expect 2 rows: the status check and the decided_by foreign key; rls_enabled = true.
SELECT conname, (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.community_join_requests'::regclass) AS rls_enabled
FROM pg_constraint
WHERE conname IN ('community_join_requests_status_check', 'community_join_requests_decided_by_fkey');
