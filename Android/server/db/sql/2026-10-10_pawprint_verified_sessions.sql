-- PawPrint 2FA / Supabase session binding (QA handoff H1, "a valid Supabase
-- session is not yet tied to a verified PawPrint 2FA completion state").
--
-- Run by hand in the Supabase SQL editor, BEFORE deploying the backend
-- change that reads/writes this table (middleware/auth.js's
-- resolveUserFromToken, routes/auth.js's /2fa/verify-login and
-- /2fa/verify-enable). Additive and idempotent: safe to run twice.
--
-- Without this table, a Supabase Auth session obtained OUTSIDE this app --
-- e.g. a raw signInWithPassword call straight against Supabase's own REST
-- API, bypassing POST /api/auth/login entirely -- is accepted by
-- authenticateAccess/authenticateSocket exactly like one that went through
-- our PawPrint challenge, because the Supabase JWT itself carries no idea
-- that this app requires a second factor. This table is the server-side
-- record of "this specific Supabase session (by GoTrue's session_id claim,
-- stable across access-token refresh) has actually completed PawPrint" --
-- written only by POST /2fa/verify-login (and by /2fa/verify-enable, for
-- the session that just turned 2FA on, so a user doesn't lock themselves
-- out mid-session) and checked on every request for a 2FA-enabled account.

CREATE TABLE IF NOT EXISTS public.pawprint_verified_sessions (
  session_id   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  verified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pawprint_verified_sessions_user
  ON public.pawprint_verified_sessions (user_id);

-- Optional but recommended once applied: speeds up the new case-insensitive
-- email lookup (M1, UserRepository.findByEmail) at current-and-future scale.
-- Safe to skip for now at this app's current row count.
-- CREATE INDEX IF NOT EXISTS idx_users_email_lower ON public.users (LOWER(email));

-- ── Verification (read-only) ──────────────────────────────────────────
-- Expect one row describing the new table.
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pawprint_verified_sessions'
ORDER BY ordinal_position;
