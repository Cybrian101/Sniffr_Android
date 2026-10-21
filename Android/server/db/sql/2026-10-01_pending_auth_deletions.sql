-- Account deletion: Supabase Auth identities waiting to be deleted.
--production

-- Run by hand in the Supabase SQL editor, BEFORE deploying the merged
-- account-deletion backend: a deletion of an email/password account (one
-- with users.auth_user_id set) refuses to run without this table, so an
-- identity can never be orphaned.
--
-- The deletion transaction records the user's Supabase identity here and
-- clears users.auth_user_id; right after COMMIT the server deletes the
-- identity through the Supabase admin API (services/authIdentityPurge.js),
-- and the hourly job retries anything left (up to 10 attempts, then the row
-- stays for a manual look). A 404 from Supabase counts as done.
--
-- deleted_user_id has no foreign key on purpose (same as
-- pending_media_deletions): the row must outlive any later cleanup of the
-- tombstoned users row. Additive and idempotent: safe to run twice.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pending_auth_deletions (
  id              BIGSERIAL PRIMARY KEY,
  auth_user_id    UUID NOT NULL,
  deleted_user_id INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pending_auth_deletions_auth_user_id_key UNIQUE (auth_user_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_auth_deletions_user
  ON public.pending_auth_deletions (deleted_user_id);

-- Keep it out of Supabase's public REST API: RLS with no policies blocks the
-- anon/authenticated roles. The server connects as the table owner
-- (postgres), which RLS does not apply to.
ALTER TABLE public.pending_auth_deletions ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ── Verification (read-only) ──────────────────────────────────────────
-- Expect one row: pending_auth_deletions | 7 columns | rls_enabled = true.
SELECT c.relname AS table_name,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pending_auth_deletions') AS columns,
       c.relrowsecurity AS rls_enabled
FROM pg_class c
WHERE c.oid = 'public.pending_auth_deletions'::regclass;
